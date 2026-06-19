# Build friction audit (free tier)

**Date:** 2026-06-19  
**Build:** `index-BPkZlyio.js`, local `http://127.0.0.1:8000`  
**Method:** Playwright harness with `createSignedInContext()` (`scripts/build-friction-audit.mjs`)  
**Raw evidence:** [`build-friction-audit-evidence.json`](./build-friction-audit-evidence.json)

**Observability (signed-in baseline run)**

| Signal | Result |
|--------|--------|
| `POST /api/clientlog` beacons | **0** |
| Browser console | **6** messages — favicon 404s + simulated 503 in recovery path |
| Required signed-in paths | **7 / 7** pass |
| Recovery paths (informational) | **3 / 3** pass (10 total scenarios) |
| Harness exit | **0** when required paths pass; **1** on any required failure |

---

## Executive summary

**Signed-in baseline (E2E evidence):** Fresh registered user sees a clear Build empty state with three create paths (board-first, ⋯ menu, Dashboard → New). Dashboard modal (name + color) opens Build with board + tree scaffold. First prepared move (`1.e4`) and alternate branch (`1.d4`) work; fork bar appears at the **parent** position; chip click or ↑/→ keyboard navigates to the alt line. Reload + Dashboard reopen restores `1.e4`. Analyze handoff CTA imports demo PGN tree into Build.

**Recovery (not gated):** Generate button correctly gated without COI; simulated `add-moves` 503 surfaces `⚠ Offline — will retry` then recovers to `✓ Saved`; Dashboard list refreshes after create (black color dot correct).

**Top P1 for next product commit:** Build **⋯ menu** touch target **28px** tall on 375px viewport (<44px guideline). Functional mobile core flow passes; polish only.

**P2 notes:** Board move input uses `pointerdown` only — keyboard cannot play moves on squares (modal + branch keys OK). Sync chip may read `• Unsaved changes` while server already has the move (reload still succeeds).

---

## Required gates

### Path 1 — Empty state (desktop)

| | |
|--|--|
| **Expected** | New account on Build: empty state clear; primary create action discoverable |
| **Actual** | `#build-rep-name` = “No repertoire open”; tree empty-state copy mentions board, ⋯ menu, Dashboard; Dashboard shows “No repertoires yet” + **New** button |
| **Evidence** | `1-signed-in/empty-state` |
| **Recovery** | Dashboard → New, Build ⋯ → New repertoire, or play first move |
| **Priority** | **P3** — OK |

### Path 2 — Create repertoire (name / color → board / tree)

| | |
|--|--|
| **Expected** | Name + color modal → Build active with rep name, 64-square board, tree scaffold |
| **Actual** | `Created …` status; `#build-rep-name` includes name + `white`; tree shows start-position breadcrumb + “Play a move…”; sync `✓ Saved` |
| **Evidence** | `2-signed-in/create-repertoire` |
| **Recovery** | Retry Dashboard → New |
| **Priority** | **P3** — OK |

### Path 3 — First prepared move + branch switch

| | |
|--|--|
| **Expected** | Play `e4`, add `d4` at root, switch between lines |
| **Actual** | At root after both moves: fork bar shows `e4` + `d4` chips; clicking `d4` navigates (`board-label` → `1. d4`); bar hides on child (by design) |
| **Evidence** | `3-signed-in/first-move-branch` |
| **Recovery** | `⏮` / `←` back to fork; ↑↓ pick, → play, or click chip |
| **Priority** | **P3** — OK |

### Path 4 — Reload persistence

| | |
|--|--|
| **Expected** | After reload, repertoire + `1.e4` still available |
| **Actual** | Pre-reload sync showed `• Unsaved changes`; post-reload Dashboard open → tree contains `1.e4`, sync `✓ Saved` |
| **Evidence** | `4-signed-in/reload-persist` |
| **Recovery** | Open from Dashboard if Build view empty on load |
| **Priority** | **P3** — data persists; **P2** — sync chip lag |

### Path 1b — Mobile 375px core flow

| | |
|--|--|
| **Expected** | Empty → create via ⋯ menu → play `e4` on 375px |
| **Actual** | Core flow completes; board width 349px; **⋯ menu height 28px** |
| **Evidence** | `1-signed-in/mobile-375` |
| **Recovery** | Use Dashboard → New if ⋯ hard to tap |
| **Priority** | **P1** — touch target (functional pass) |

### Path 1c — Keyboard core flow

| | |
|--|--|
| **Expected** | Keyboard completes create + branch switch at fork |
| **Actual** | Enter on ⋯ → New repertoire modal creates rep; `ArrowUp` + `ArrowRight` at root fork plays `1.d4`; board moves still need pointer |
| **Evidence** | `1-signed-in/keyboard` |
| **Recovery** | Pointer for board; keys for fork navigation |
| **Priority** | **P3** — partial OK; **P2** — no keyboard board play |

### Path 5 — Analyze handoff entry

| | |
|--|--|
| **Expected** | Analyze CTA (no existing repertoire) → modal → Build with imported tree |
| **Actual** | `create-repertoire-from-game` visible; Build opens with `1.e4 e5 2.Nf3 Nc6 3.Bb5 a6` in tree |
| **Evidence** | `5-signed-in/handoff-entry` |
| **Recovery** | Retry CTA on analysis panel |
| **Priority** | **P3** — OK |

---

## Recovery scenarios (not required)

| Path | Expected | Actual | Priority |
|------|----------|--------|----------|
| `3-recovery/engine-gate` | Generate disabled without COI | `disabled`, `aria-disabled`, recovery title | **P2** — OK |
| `4-recovery/sync-failure` | 503 → error chip → retry → saved | `⚠ Offline — will retry` → `✓ Saved` | **P2** — OK |
| `5-recovery/dashboard-refresh` | Dashboard lists new rep | Name + black dot present | **P3** — OK |

---

## Cross-cutting accessibility & mobile

| Issue | Evidence | Priority |
|-------|----------|----------|
| Build ⋯ menu **28px** touch target on 375px | `mobile-375` `menuHeight: 28` | **P1** |
| Board squares listen to `pointerdown` only — no keyboard move play | `keyboard` scenario uses pointer for e4/d4 setup | **P2** |
| Fork bar only at parent node — must step back to see alternatives | `first-move-branch` `beforeSwitch` vs `afterSwitch` | **P2** — learnability |
| Sync chip `dirty` while server already persisted move | `reload-persist` `syncBefore.is-dirty` | **P2** |
| Dashboard metrics “Repertoires” still **0** after create | `dashboard-refresh` `metricsRepertoires: "0"` | **P2** |

---

## Priority stack (Build rubric)

1. **P1 — Mobile touch target** — raise Build ⋯ menu (and audit other Build chrome) to ≥44px on 375px
2. **P2 — Keyboard board play** — Space/Enter on focused square + legal target
3. **P2 — Sync chip accuracy** — reflect server-persisted state after flush/beacon
4. **P2 — Dashboard metrics** — repertoire count after create
5. **P3 — Core signed-in flow** — empty → create → move → branch → reload → handoff (all gated green)

---

## Next commit scope (one friction only)

**Build P1 — ⋯ menu touch target on mobile (375px).** Do not bundle keyboard board play or sync-chip work.

---

## Re-run harness

```powershell
# Terminal 1 — migrate once per dev DB; disable auth rate limit (~10 registrations/run)
$env:DATABASE_URL="sqlite:///dev.sqlite3"
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -c "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1', port=8000)"

# Terminal 2 — exits 1 if any required signed-in scenario fails
node scripts/build-friction-audit.mjs
```

Do **not** commit `dev.sqlite3-shm` / `dev.sqlite3-wal` (local audit DB artifacts).