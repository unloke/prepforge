# ORCBR-B1 — Raw Materialization / Acquisition Protocol

**Status:** FROZEN — acquisition-only (not algorithm execution; not confirmatory)
**Date frozen:** 2026-07-27
**Protocol ID:** `scout-orcbr-b1-raw-acq-v1`
**Kind:** `scout-orcbr-b1-raw-acquisition-protocol`
**Role:** `raw-materialization-only`
**Related algorithm protocol:** `scout-orcbr-b1-v1` (thresholds remain frozen; **not** modified here)
**Product:** `productAuthorization: false` · `productVerdict: preserve-v2`
**Module A:** `CLOSED_NOT_REOPENED`
**Scout production:** v2 default unmodified

> This document freezes a **separate** custody acquisition identity for ORCBR-B1
> raw materialization. It does **not** run ORCBR gates, does **not** open CAL/TEST,
> does **not** evaluate outcomes, and must **not** retune algorithm thresholds after
> seeing data. Authentic parent EBB/SHPFA raw is foreign burned/TEST-opened and
> forbidden. Inventory finding: **`NO_EXISTING_LAWFUL_RAW_CUSTODY`**.

---

## 0. Locks (immutable for this identity)

| Field | Frozen value |
|---|---|
| `kind` | `scout-orcbr-b1-raw-acquisition-protocol` |
| `version` | `1` |
| `protocolId` | `scout-orcbr-b1-raw-acq-v1` |
| `candidateId` | `orcbr-b1` |
| `role` | `raw-materialization-only` |
| `productAuthorization` | **`false`** |
| `productVerdict` | **`preserve-v2`** |
| `moduleAStatus` | `CLOSED_NOT_REOPENED` |
| `calAllowed` / `testAllowed` / `calTestSplitAllowed` | **`false`** |
| `outcomeEvaluationAllowed` | **`false`** |
| `orcbrGatesAllowed` | **`false`** |
| `networkEnabledDefault` | **`false`** |
| `networkRequiresExplicitExecuteFlag` | **`true`** (`--confirm-execute`) |

### Claim boundary

| Establishes | Forbids |
|---|---|
| Lawful sealed raw NDJSON custody for later ORCBR **schema/structural** research | ORCBR algorithm execution under this identity |
| Deterministic subject panel independent of ORCBR outcomes | Result-based or performance-based subject selection |
| Exact raw/capped hashes + HTTP receipts (no raw identity in reports) | Reusing EBB/SHPFA/opened subjects as confirmation |
| | Reusing burned Black-panel subjects (`unbrainless87`, …) or ORCBR fixtures |
| | Retuning frozen ORCBR thresholds after seeing data |
| | Product ship / Module A reopen / Scout v2 replacement |

---

## 1. Why a separate acquisition identity

The algorithm protocol (`scout-orcbr-b1-v1`) freezes **networkEnabled: false** and
requires **local** raw for G0. That is correct for gate execution.

This identity answers a different question: **how to lawfully materialize raw
bytes** when no existing lawful custody exists, without contaminating algorithm
thresholds or confirmatory holdouts.

```text
scout-orcbr-b1-raw-acq-v1  →  sealed raw/capped custody
scout-orcbr-b1-v1          →  dual-parse / gates / package (separate CLI; not this task)
```

---

## 2. Subject source (freeze-before-network)

### 2.1 Prefer repo non-outcome metadata

Subjects are selected from a **frozen allowlist** of public Lichess usernames that
already appear in **non-outcome** repository metadata (smoke tests / fetch examples),
after verifying presence in pinned source files:

| Source file | Role |
|---|---|
| `tests/e2e/scout_smoke.mjs` | E2E default public export username |
| `scripts/scout-fetch-games.mjs` | Raw-preserving fetch example |

**Allowlist (v1):** `DrNykterstein` only.

### 2.2 Forbidden subjects (always exclude)

| Category | Examples |
|---|---|
| Prior burned Black panels / robust-y cohort anchor | `unbrainless87` |
| ORCBR synthetic fixtures | `subject1`, `OppRepeat`, … |
| EBB/SHPFA opened foreign custody | any parent burned/TEST-opened subjects |

### 2.3 Selection rule (no ORCBR performance)

1. Normalize candidates lower-case.
2. Exclude forbidden set.
3. Require appearance in ≥1 frozen source file text.
4. Sort `localeCompare` ascending.
5. Take first `maxSubjects` (must have ≥ `minSubjects`).

**Frozen counts:** `minSubjects = 1`, `maxSubjects = 1`.

If qualified count &lt; `minSubjects` → **`STOP_ACQUISITION_PANEL_UNAVAILABLE`**
and **stop before any network call**.

Selection **must not** read ORCBR gate outcomes, package scores, or any
performance ranking.

---

## 3. Fetch settings (frozen)

| Setting | Value |
|---|---|
| Endpoint | `GET https://lichess.org/api/games/user/{username}` |
| `max` | **200** games / subject |
| `perfType` | `blitz,rapid,classical` (bullet excluded) |
| `pgnInJson` | `true` |
| `moves` / `clocks` | `true` |
| `evals` / `opening` | `false` |
| `Accept` | `application/x-ndjson` |
| `until` | `acquisitionUntilMs` from freeze snapshot |
| Inter-subject delay | 1200 ms (bounded) |
| Rate limit | **stop on 429** — no aggressive retry |
| HTTP failure | **stop** + write receipt |

### Deterministic cap

Keep the first `maxGamesPerSubject` **complete non-empty NDJSON lines** in export
order. Preserve exact line bytes. Capped file ends with a trailing newline when
non-empty.

### Salt

- Frozen study salt in protocol identity (HMAC key).
- Reports/manifests emit only `subjectKey = "subj_" + HMAC-SHA256(salt, id)[0:16]`.
- Snapshot stores `saltSha256`; raw files may contain upstream identity (sealed custody).

---

## 4. Burn declaration

On successful execute:

```text
ACQUIRED_RAW_SEALED_NEWLY_BURNED_FOR_ORCBR_SCHEMA_STRUCTURAL_RESEARCH
```

Once inspected for schema/structural research:

```text
ACQUIRED_RAW_BURNED_FOR_ORCBR_SCHEMA_STRUCTURAL_RESEARCH_ONCE_INSPECTED
```

**Acquisition outputs are newly burned for ORCBR schema/structural research once
inspected.** They are **not** confirmatory holdouts and must not be reused as
EBB/SHPFA/Module A confirmation.

---

## 5. Layout

```text
docs/scout-orcbr-b1-acquisition.md
research/scout-orcbr-b1-acq/
  orcbr-b1-acq.protocol.json
  orcbr-b1-acq.js
  orcbr-b1-acq.test.js
scripts/scout-orcbr-b1-acq.mjs

tmp/scout-orcbr-b1-acq/                 # study root (gitignored)
  protocol.snapshot.json
  subject-panel.json                    # may hold local raw ids for fetch only
  custody/subjects/<subjectKey>/
    raw.ndjson
    raw.sha256
    capped.ndjson
    capped.sha256
    http-receipt.json                   # no raw identity
  manifest.json                         # no raw identity
  report.json                           # no raw identity; self-hash last
  state.json
  events.ndjson
```

---

## 6. CLI

```bash
node scripts/scout-orcbr-b1-acq.mjs freeze
node scripts/scout-orcbr-b1-acq.mjs select
node scripts/scout-orcbr-b1-acq.mjs execute --confirm-execute
node scripts/scout-orcbr-b1-acq.mjs status
node scripts/scout-orcbr-b1-acq.mjs verify
```

| Command | Network? | Behavior |
|---|---|---|
| `freeze` | **No** | Snapshot protocol + `acquisitionUntilMs` boundary + salt hash |
| `select` | **No** | Deterministic panel; may `STOP_ACQUISITION_PANEL_UNAVAILABLE` |
| `execute` | **Only with `--confirm-execute`** | Fetch → raw/capped custody → receipts → manifest → report |
| `status` | No | Latest verdict + product flags |
| `verify` | No | Rehash; tamper → `TAMPER_DETECTED` |

Default without `--confirm-execute` → **`ACQ_NETWORK_DISABLED`**.

---

## 7. Terminal verdicts

```text
ACQ_PROTOCOL_FROZEN
ACQ_PANEL_SELECTED
STOP_ACQUISITION_PANEL_UNAVAILABLE
ACQ_NETWORK_DISABLED
ACQ_EXECUTE_OK
STOP_ACQUISITION_HTTP_FAILURE
STOP_ACQUISITION_RATE_LIMIT
STOP_ACQUISITION_FREEZE_REQUIRED
INVALID
TAMPER_DETECTED
```

---

## 8. Tests (required)

| Case | Assertion |
|---|---|
| Freeze-before-fetch | execute without freeze → `STOP_ACQUISITION_FREEZE_REQUIRED` |
| Forbidden exclusion | `unbrainless87` / fixture subjects never selected |
| No result-based selection | Performance / ORCBR outcome rankings ignored |
| Hash / tamper | mutated raw → `TAMPER_DETECTED` |
| No raw identity in receipts | known username absent from receipt/report JSON |
| Network-disabled default | execute without flag → `ACQ_NETWORK_DISABLED` |
| Deterministic cap | same raw + max → identical capped bytes/hash |
| HTTP failure stops | non-2xx → `STOP_ACQUISITION_HTTP_FAILURE`; 429 → rate-limit stop |

---

## 9. Operator checklist

- [ ] Freeze **before** any network call
- [ ] Panel selected offline; stop if unavailable
- [ ] Explicit `--confirm-execute` for network
- [ ] Raw sealed; reports identity-free
- [ ] No ORCBR gates / CAL / TEST under this CLI
- [ ] Algorithm protocol thresholds untouched
- [ ] Burn declaration recorded on execute
- [ ] `productAuthorization: false`, Module A closed, Scout v2 preserved

---

## 10. Live execute + burn status (structural custody)

One-subject panel (`maxSubjects=1`) was selected offline from the frozen allowlist
via non-outcome repo metadata (not a forbidden prior panel; not result-based).
Network execute with `--confirm-execute` sealed raw + capped (cap 200) under
`tmp/scout-orcbr-b1-acq/`.

| Item | Status |
|---|---|
| Execute verdict | `ACQ_EXECUTE_OK` |
| Burn on execute | `ACQUIRED_RAW_SEALED_NEWLY_BURNED_FOR_ORCBR_SCHEMA_STRUCTURAL_RESEARCH` |
| After ORCBR G0–G2 inspection | Treat as **`ACQUIRED_RAW_BURNED_FOR_ORCBR_SCHEMA_STRUCTURAL_RESEARCH_ONCE_INSPECTED`** |
| Scientific use | Lawful local raw for **schema/structural** ORCBR research only |
| Confirmation | **Forbidden** — not EBB/SHPFA/Module A confirmation; not a confirmatory holdout |
| Algorithm thresholds | Untouched (`scout-orcbr-b1-v1` pins remain frozen) |

Downstream algorithm run (separate CLI) stopped at G2
`STOP_NO_LONGITUDINAL_RECURRENCE` under frozen floors — structural preflight only.

---

## 11. Document control

| Item | Value |
|---|---|
| Normative path | `docs/scout-orcbr-b1-acquisition.md` |
| Machine companion | `research/scout-orcbr-b1-acq/orcbr-b1-acq.protocol.json` |
| Algorithm protocol (separate) | `docs/scout-orcbr-b1-protocol.md` |
| Supersession | Material change → new `protocolId` / version |
| Live custody | §10 — newly burned for ORCBR schema/structural research once inspected |
