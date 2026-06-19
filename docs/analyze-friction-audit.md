# Analyze friction audit (free tier)

**Date:** 2026-06-19  
**Build:** post-P0 fix (`index-DBqBJsd1.js`, local `http://127.0.0.1:8000`)  
**Method:** Code review + Playwright harness (`scripts/analyze-friction-audit.mjs`) + API tests (`tests/test_api_analyze.py`)  
**Raw evidence:** [`analyze-friction-audit-evidence.json`](./analyze-friction-audit-evidence.json)

**Observability (post-P0 re-run)**

| Signal | Result |
|--------|--------|
| `POST /api/clientlog` beacons | **0** |
| Browser console | **7** messages — one `404` asset + auth-modal DOM warnings (no `401` on guest Analyze) |
| Guest session | Default SPA boot (no sign-in) |
| Harness | **7 / 9** pass flags (P0 paths green; `huge-pgn` fill timeout + `no-coi` click-on-disabled are harness gaps) |

---

## Executive summary

**P0 fixed:** Guest Analyze now checks `!appState.signedIn` before `postJson("/api/analyze/prepare")` and on `error.status === 401`. Status shows **“Sign in (or create an account) to analyze and save games”** and **`openAuthModal("login")`** opens immediately. No raw `not authenticated` string; button stays enabled for retry after sign-in.

**Next single fix candidate (P1):** Result handoff for signed-in users without a repertoire — bookline stays hidden with no guided “create repertoire from this game” step.

---

## Path 1 — New user: valid PGN → Analyze → results

| | |
|--|--|
| **Expected** | Paste/load valid PGN → click Analyze → progress → eval chart + move list + summary |
| **Actual (guest, post-fix)** | Click Analyze → status **“Sign in (or create an account) to analyze and save games”** + auth modal; no API call; `#analysis-results` hidden; `#run-analysis` stays enabled |
| **Evidence** | `evidence.json` `1-happy-path/desktop-1280-guest`, `mobile-375-guest`, `keyboard-guest` |
| **Recovery** | Complete sign-in in modal, then Analyze again |
| **Desktop 1280** | **Pass** (auth gate + CTA) |
| **Mobile 375** | **Pass** (auth modal; touch target height 32px — P1 mobile polish) |
| **Keyboard** | **Pass:** Enter on focused `#run-analysis` opens auth modal. First Tab still lands on **`nav-build`** (P2 tab order) |
| **Priority** | **P3** — guest gate OK; signed-in happy path still needs manual smoke |

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
| **Actual (post-fix)** | Same auth gate as valid PGN — sign-in modal before parse |
| **Recovery** | Sign in first, then fix PGN if still invalid |
| **Priority** | **P3** — no longer misleading |

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

1. ~~**P0 — Auth gate UX on Analyze**~~ **Done** (`runAnalysis` pre-check + 401 catch)
2. ~~**P1 — Misleading errors** on invalid PGN for guests~~ **Resolved** by P0
3. **P1 — Result handoff** for users with no repertoire (signed-in smoke)
4. **P2 — Keyboard / discoverability** (tab order, open PGN drawer hint, engine status in status bar)
5. **P2 — Huge paste** guard
6. **P3 — Empty PGN** (already good)

---

## Next commit scope (one friction only)

**P1 result handoff** or **P2 keyboard/discoverability** — pick one after signed-in Analyze smoke confirms engine path. Do not bundle with auth work.

---

## Re-run harness

```powershell
# Terminal 1
$env:DATABASE_URL="sqlite:///dev.sqlite3"
.\.venv\Scripts\python.exe -m uvicorn prepforge_chess.api.main:app --host 127.0.0.1 --port 8000

# Terminal 2
node scripts/analyze-friction-audit.mjs
```