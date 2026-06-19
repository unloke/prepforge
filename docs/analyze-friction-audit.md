# Analyze friction audit (free tier)

**Date:** 2026-06-19  
**Build:** `4fcedf8` (local `http://127.0.0.1:8000`, committed static SPA)  
**Method:** Code review + Playwright harness (`scripts/analyze-friction-audit.mjs`) + API tests (`tests/test_api_analyze.py`)  
**Raw evidence:** [`analyze-friction-audit-evidence.json`](./analyze-friction-audit-evidence.json)

**Observability this run**

| Signal | Result |
|--------|--------|
| `POST /api/clientlog` beacons | **0** (no uncaught exceptions during scenarios) |
| Browser console | **7** messages — one `404` asset + **six `401 Unauthorized`** on analyze/workspace calls |
| Guest session | Default SPA boot (no sign-in) |

---

## Executive summary

The highest-impact friction is **guest Analyze hitting a hard auth wall with no recovery UX**. Demo PGN is prefilled and the Analyze button is enabled (when COI is OK), but `/api/analyze/prepare` requires `current_owner` → **401 `not authenticated`**. The status bar shows that raw API detail with **no sign-in prompt, no modal, no inline CTA**.

**Recommended single fix for next commit (P0):** In `runAnalysis()`, detect `!appState.signedIn` or `error.status === 401` and surface an actionable message (e.g. “Sign in to analyze and save games”) plus `openAuthModal("login")` / focus account chip — before or instead of a generic `setStatus(error.message)`.

---

## Path 1 — New user: valid PGN → Analyze → results

| | |
|--|--|
| **Expected** | Paste/load valid PGN → click Analyze → progress → eval chart + move list + summary |
| **Actual (guest)** | `prefillDemoPgn()` runs on `init()`; PGN drawer **closed** but textarea has demo PGN. Click Analyze → status **“Analyzing PGN”** briefly → **`not authenticated`**; `#analysis-results` stays hidden; `#run-analysis` re-enabled |
| **Evidence** | `evidence.json` path `1-happy-path/desktop-1280`; console `401` on prepare; `tests/test_api_analyze.py::test_prepare_requires_auth` |
| **Recovery today** | User must discover top-bar **Sign in** alone; no link from status or Analyze sidebar |
| **Desktop 1280** | Fail (auth) |
| **Mobile 375** | Not completed (harness CSP `waitForFunction` issue); layout of controls not blocking |
| **Keyboard** | **Pass partial:** Enter on focused `#run-analysis` starts job (`runDisabled: true`, status “Analyzing PGN”) — `evidence.json` `1-happy-path/keyboard`. First Tab lands on **`nav-build`**, not Analyze content |
| **Priority** | **P0** — core free-tier promise blocked |

**Signed-in note:** API prepare/classify path is covered by pytest (`test_prepare_returns_positions_and_move_skeleton`). Full browser Stockfish WASM completion was not re-captured in this harness run (registration UI flow blocked automation); treat engine happy path as **provisionally OK** pending manual signed-in smoke.

---

## Path 2 — Import failures

### 2a Empty PGN

| | |
|--|--|
| **Expected** | Client guard; no network; clear message |
| **Actual** | Status **“Paste PGN before analyzing”**; button stays enabled |
| **Recovery** | Open PGN drawer, paste text |
| **Priority** | **P3** — OK |

### 2b Invalid PGN (guest)

| | |
|--|--|
| **Expected** | Parse/import error (400) with fix hint |
| **Actual** | **`not authenticated`** (401 on prepare before parse) — **misleading** |
| **Recovery** | User may try to “fix PGN” when they need to sign in |
| **Priority** | **P1** — wrong failure class (folds into P0 auth UX) |

### 2c Huge / interrupted input

| | |
|--|--|
| **Expected** | Graceful limit or fast failure |
| **Actual** | Playwright `fill()` **timeout 30s** on ~8000-line textarea paste |
| **Recovery** | Unknown — no client size guard in `runAnalysis()` |
| **Priority** | **P2** — perf/DoS-ish paste; defer until P0 fixed |

---

## Path 3 — Engine unavailable

### 3a Non-isolated environment (COOP/COEP missing)

| | |
|--|--|
| **Expected** | Clear gate + recovery (supported browser / host) |
| **Actual** | `#run-analysis` gets `is-coming-soon`, `disabled`, `aria-disabled`, title **`Browser engine unavailable — open in a cross-origin-isolated browser…`** (`applyServerEngineGating()`). Status bar does **not** mirror this until user attempts click |
| **Recovery** | Title attribute only; Settings engine panel lazy — not visible until Settings tab |
| **Priority** | **P2** — gating works; proactive status copy would help |

### 3b Stockfish / Maia load failure

| | |
|--|--|
| **Expected** | Toast progress → fail message → retry |
| **Actual (code)** | `runAnalysis` catch → `setStatus(error.message)` + `jobToast.failJob()`; Maia brilliant path **non-fatal** (swallows, continues without `!!`). Settings **Retry now / Reset cache** only in Settings chunk |
| **Recovery** | Re-run Analyze; Maia recovery buried in Settings |
| **Priority** | **P2** — needs signed-in long run to reproduce live |

---

## Path 4 — Long task: progress, Stop, cancel, retry

| | |
|--|--|
| **Expected** | Job toast with `evaluating N/M`, **Stop** (`job-toast-stop`), cancel → “Analysis stopped”, button re-enabled, retry works |
| **Actual (guest)** | Cannot reach engine phase — fails at prepare 401 |
| **Actual (code review)** | `jobToast.startJob` + `onCancel` → `cancelled` flag; post-eval checkpoint; `lockJob()` before classify-save (save not cancellable) |
| **Harness** | Long-PGN scenario aborted (invalid `querySelector` pseudo + guest auth) |
| **Recovery** | Stop then Analyze again (when authed) |
| **Priority** | **P1** — validate signed-in after P0; code path looks sound |

---

## Path 5 — Result handoff → Build / Train

| | |
|--|--|
| **Expected** | After analysis, clear next step (bookline → Train / Add in Build) |
| **Actual (guest)** | No results → no handoff |
| **Actual (signed-in, code)** | `updateBookline()` shows coach chip **Train it** / **Add it in Build** only when `appState.signedIn` + repertoire match + out-of-book ply; otherwise hidden. No generic “Create repertoire from this game” on Analyze results |
| **Recovery** | Manual **Build** / **Train** tabs; sign in + build book first |
| **Priority** | **P1** for new users (no guided next step); **P3** for established users with reps |

---

## Accessibility & mobile (cross-cutting)

| Issue | Evidence | Priority |
|-------|----------|----------|
| Tab order starts at **nav-build**, not Analyze PGN/primary CTA | `keyboard` scenario `initialFocus: BUTTON nav-build` | **P2** |
| PGN in **collapsed** `<details>` — demo content not visible | `index.html` `#pgn-drawer`; `prefillDemoPgn()` on init | **P2** |
| Gated Analyze button: `aria-disabled="true"` when no COI | `3-engine-unavailable` click log | **P3** — OK pattern |
| Status-only errors (no `role="alert"` on failures) | `#app-status` text only | **P2** |

---

## Priority stack (UI/UX rubric order)

1. **P0 — Auth gate UX on Analyze** (error/retry feedback): guest sees `not authenticated` with no CTA → **fix next commit**
2. **P1 — Misleading errors** when guest pastes bad PGN (same 401 string)
3. **P1 — Result handoff** for users with no repertoire (after auth fixed)
4. **P2 — Keyboard / discoverability** (tab order, open PGN drawer hint, engine status in status bar)
5. **P2 — Huge paste** guard
6. **P3 — Empty PGN** (already good)

---

## Next commit scope (one friction only)

Implement **P0 auth recovery on Analyze** only:

- Before `postJson("/api/analyze/prepare")` **or** in `catch` when `error.status === 401`
- Set status: e.g. “Sign in to analyze and save games”
- Call `openAuthModal("login")` (or highlight `#account-chip`)
- Do **not** expand into Build/Train handoff or engine banner work in the same commit

---

## Re-run harness

```powershell
# Terminal 1
$env:DATABASE_URL="sqlite:///dev.sqlite3"
.\.venv\Scripts\python.exe -m uvicorn prepforge_chess.api.main:app --host 127.0.0.1 --port 8000

# Terminal 2
node scripts/analyze-friction-audit.mjs
```