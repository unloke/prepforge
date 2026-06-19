# Train friction audit (free tier)

**Date:** 2026-06-19  
**Build:** `index-GAWjW1KI.js`, local `http://127.0.0.1:8000`  
**Method:** Playwright harness with `createSignedInContext()` (`scripts/train-friction-audit.mjs`)  
**Raw evidence:** [`train-friction-audit-evidence.json`](./train-friction-audit-evidence.json)

**Observability (signed-in baseline run)**

| Signal | Result |
|--------|--------|
| `POST /api/clientlog` beacons | **0** |
| Browser console | **14** messages — favicon 404s + simulated 503 in recovery path |
| Required signed-in paths | **8 / 8** pass |
| Recovery paths (informational) | **3 / 3** pass (11 total scenarios) |
| Harness exit | **0** when required paths pass; **1** on any required failure |

---

## Executive summary

**Signed-in baseline (E2E evidence):** Fresh user on Train sees idle banner + board label; **Start** without a repertoire surfaces **“Nothing to train yet”** + **“Add prepared moves in Build, then train.”** After Build adds `1.e4`, Smart queue starts (teach-first **New move: e4**); Line rehearsal picker lists the repertoire. Correct `e4` increments **Correct** / streak; wrong `d4` shows **“Not that one - try again”** with free retry; fixed-on-retry completes session. Reload after sync → fresh session stats (`0` correct) but training restarts cleanly (next card **Polish**). Build → Train handoff lists new repertoire in picker and starts Smart session.

**Recovery (not gated):** Empty repertoire (no prepared moves) gates with Build hint; simulated `smart/sync` 503 → `⚠ Offline — will retry` then recovers; mid-session reload restarts UI (in-memory session not restored — expected).

**Top P1 for next product commit:** **Start training** button **321×32px** on 375px (<44×44px). Board bar controls (hint/skip/flip) **28px** tall. Functional mobile flow passes; touch-target polish only.

**P2 notes:** Train board squares use `pointerdown` only — keyboard Enter on square does not play moves (Start via Enter works).

---

## Required gates

### Path 1 — Empty state

| | |
|--|--|
| **Expected** | New account on Train: prerequisites clear; actionable Build path |
| **Actual** | Idle: board label “Press Start to train”; Start → banner **Nothing to train yet** + sub **Add prepared moves in Build…**; status **no active repertoires to train**; `nav-build` present |
| **Evidence** | `1-signed-in/empty-state` |
| **Recovery** | Build repertoire with prepared moves |
| **Priority** | **P3** — OK |

### Path 2 — Ready after Build

| | |
|--|--|
| **Expected** | Prepared move in Build → Train: picker lists rep (Line rehearsal); Smart queue starts first prompt |
| **Actual** | Picker shows `Audit Train … (white)`; Smart start returns 1 card; banner **teach** state with e4 idea |
| **Evidence** | `2-signed-in/ready-to-start` |
| **Recovery** | Flush Build sync before Start |
| **Priority** | **P3** — OK |

### Path 3 — Correct move

| | |
|--|--|
| **Expected** | Correct prepared move updates stats / progress |
| **Actual** | **Correct** `0→1`, streak `1`, session completes (**1 first-try correct**) |
| **Evidence** | `3-signed-in/correct-move` |
| **Recovery** | Follow teach arrow / banner |
| **Priority** | **P3** — OK |

### Path 4 — Wrong move + retry

| | |
|--|--|
| **Expected** | Wrong move: clear retry; correct on retry advances without double-counting first-try mistakes |
| **Actual** | Wrong `d4` → **Not that one - try again**; mistakes `1`; retry `e4` → session done **1 fixed on retry** (first-try correct stays `0`) |
| **Evidence** | `4-signed-in/wrong-retry` |
| **Recovery** | Read hint sub; replay expected move |
| **Priority** | **P3** — OK |

### Path 5 — Reload / re-entry

| | |
|--|--|
| **Expected** | After graded move + reload: reasonable recovery; no reset errors or double UI scoring |
| **Actual** | Pre-reload correct `1`, sync saved; post-reload Start → new session stats `0`, prompt **Polish** card (SR-aware queue, not duplicate in-memory session) |
| **Evidence** | `5-signed-in/reload-persist` |
| **Recovery** | Start again; prior attempts flushed via sync/beacon |
| **Priority** | **P3** — OK; **P2** — in-memory session not restored (by design with `fresh: true`) |

### Path 1b — Mobile 375px

| | |
|--|--|
| **Expected** | Start, answer, wrong retry, finish on 375px; record control dimensions |
| **Actual** | Core flow completes; **Start** `321×32px`; hint/skip/flip `28px`; smart-mode chip `30px` tall |
| **Evidence** | `1-signed-in/mobile-375` |
| **Recovery** | Functional on mobile today |
| **Priority** | **P1** — touch targets (functional pass) |

### Path 1c — Keyboard

| | |
|--|--|
| **Expected** | Tab/Enter reaches non-board controls; board pointer-only documented |
| **Actual** | Enter on **Start training** begins session; Enter on square does not change banner (pointer required) |
| **Evidence** | `1-signed-in/keyboard` |
| **Recovery** | Pointer for board |
| **Priority** | **P2** — board needs pointer |

### Path 6 — Build → Train handoff

| | |
|--|--|
| **Expected** | Freshly built repertoire available in Train and Smart session starts |
| **Actual** | Line rehearsal picker includes new rep; Smart queue teach prompt active |
| **Evidence** | `6-signed-in/handoff-entry` |
| **Recovery** | Ensure Build sync before Train |
| **Priority** | **P3** — OK |

---

## Recovery scenarios (not required)

| Path | Expected | Actual | Priority |
|------|----------|--------|----------|
| `4-recovery/no-trainable-moves` | Empty rep → nothing to train | Banner + Build sub | **P3** — OK |
| `5-recovery/sync-failure` | 503 → error chip → recover | `⚠ Offline — will retry` → `✓ Saved` | **P2** — OK |
| `6-recovery/reload-interrupt` | Mid-session reload | UI restarts; new Polish card on Start | **P2** — informational |

---

## Cross-cutting accessibility & mobile

| Issue | Evidence | Priority |
|-------|----------|----------|
| **Start training** button **32px** tall on 375px (full width) | `mobile-375` `startTrain: 321×32` | **P1** |
| Board bar **hint / skip / flip** **28px** on mobile | `mobile-375` layout | **P1** |
| Smart mode chip **30px** tall | `mobile-375` `smartModeEl` | **P2** |
| Board `pointerdown` only — no keyboard move play | `keyboard` `boardNeedsPointer` | **P2** |
| Banner copy in `#train-banner-title`, not `#train-prompt` | harness notes | **P3** — audit selector |

---

## Priority stack (Train rubric)

1. **P1 — Mobile touch targets** — Start training + board-bar icons ≥44px on `max-width: 720px`
2. **P2 — Keyboard board play** — Space/Enter on focused square + legal target
3. **P2 — Session resume** — document/consider resuming in-memory Smart session after reload (today: fresh queue)
4. **P3 — Core signed-in flow** — empty → Build prep → start → correct/wrong/reload → handoff (all gated green)

---

## Next commit scope (one friction only)

**Train P1 — Start training button touch target on mobile (375px).** Match Analyze/Build pattern (`min-height: 44px` at `max-width: 720px`). Do not bundle keyboard board play.

---

## Re-run harness

```powershell
# Terminal 1 — local audit server only; disables auth rate limit (~10 registrations/run)
$env:DATABASE_URL="sqlite:///dev.sqlite3"
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -c "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1', port=8000)"

# Terminal 2 — exits 1 if any required signed-in scenario fails
node scripts/train-friction-audit.mjs
```

Do **not** commit `dev.sqlite3-shm` / `dev.sqlite3-wal` (local audit DB artifacts).