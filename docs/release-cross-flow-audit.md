# Release cross-flow verification (free tier)

**Date:** 2026-06-19  
**Build:** `index-CTpIEz7N.js`, `index-DyGCAhP0.css`, local `http://127.0.0.1:8001`  
**Database:** `sqlite:///release.sqlite3` (isolated release DB)  
**Method:** Playwright harness — single fresh user, one browser context (`scripts/release-cross-flow.mjs`)  
**Gate runner:** `scripts/run-release-gates.mjs`  
**Raw evidence:** [`release-cross-flow-audit-evidence.json`](./release-cross-flow-audit-evidence.json)

**Observability (release journey run)**

| Signal | Result |
|--------|--------|
| `POST /api/clientlog` beacons | **0** |
| Browser console (non-benign errors) | **0** — favicon 404s filtered as benign |
| Required release steps | **8 / 8** pass |
| Harness exit | **0** when all required steps pass; **1** on any failure |

---

## Executive summary

**Release journey (E2E evidence):** One newly registered account completes the full free-tier core flow without product changes:

1. Analyze a valid demo PGN → move list + classification summary (`Analysis ready: 6 plies`).
2. **Turn this game into a repertoire** → name/color modal → Build opens with imported tree.
3. Repertoire persisted server-side (`/api/repertoires`).
4. Train Line picker lists the repertoire; Smart queue starts (**New move: e4**).
5. Correct first expected move (`e4`) → **Correct** `0→1`, next prompt **New move: Nf3**.
6. Reload → repertoire on Dashboard; Train restarts with fresh session stats (`0` correct); sync **✓ Saved** (no stuck error state).
7. Dashboard lists repertoire; no client errors or clientlog beacons across Analyze / Build / Train / Dashboard tabs.

**Friction audits (same gate run, port 8001):** Analyze **4/4** required, Build **7/7** required, Train **8/8** required — all green.

**Scope:** Harness, evidence, documentation, and gate runner only. No product feature changes in this commit.

**Next phase:** Production observability — client error log, UptimeRobot, and real-user feedback to prioritize backlog.

---

## Required release journey

### Step 1 — Fresh account sign-in

| | |
|--|--|
| **Expected** | Single new account registered; session active for full journey |
| **Actual** | API register + browser session; `signedInVerified: true` |
| **Evidence** | `release/signed-in` |
| **Priority** | **P3** — OK |

### Step 2 — Analyze valid PGN

| | |
|--|--|
| **Expected** | Valid PGN → results + summary; no client errors |
| **Actual** | Move list visible, classification bars, handoff CTA; `consoleErrorsSoFar: 0` |
| **Evidence** | `release/analyze-results` |
| **Priority** | **P3** — OK |

### Step 3 — Handoff: game → repertoire

| | |
|--|--|
| **Expected** | **Turn this game into a repertoire** → name/color modal → Build |
| **Actual** | Modal completed; Build active; status confirms repertoire created |
| **Evidence** | `release/handoff-create` |
| **Priority** | **P3** — OK |

### Step 4 — Build imported tree

| | |
|--|--|
| **Expected** | Build shows imported PGN tree; repertoire exists server-side |
| **Actual** | Tree shows `1.e4 e5 2.Nf3 Nc6 3.Bb5 a6`; `hasRepServer: true` |
| **Evidence** | `release/build-tree` |
| **Priority** | **P3** — OK |

### Step 5 — Train Smart queue start

| | |
|--|--|
| **Expected** | Repertoire in Line picker; Smart queue starts first prompt |
| **Actual** | Picker lists `Release Journey … (white)`; banner **New move: e4**; sync saved |
| **Evidence** | `release/train-start` |
| **Priority** | **P3** — OK |

### Step 6 — Correct first move

| | |
|--|--|
| **Expected** | First expected move grades correct; stats/progress update |
| **Actual** | `e2e4` → Correct `0→1`; next banner **New move: Nf3** |
| **Evidence** | `release/train-correct` |
| **Priority** | **P3** — OK |

### Step 7 — Reload persistence

| | |
|--|--|
| **Expected** | Reload: repertoire on Dashboard; Train restarts; fresh stats; no stuck sync |
| **Actual** | Dashboard has rep; post-reload correct `0`; Train sync **✓ Saved** |
| **Evidence** | `release/reload-persist` |
| **Priority** | **P3** — OK |

### Step 8 — Dashboard + cross-tab observability

| | |
|--|--|
| **Expected** | Dashboard lists repertoire; no console errors or clientlog beacons |
| **Actual** | `consoleErrorCount: 0`, `clientlogBeacons: 0` |
| **Evidence** | `release/dashboard-verify` |
| **Priority** | **P3** — OK |

---

## Release gate stack

`node scripts/run-release-gates.mjs` runs in order (exits **1** on first failure):

| Gate | Command |
|------|---------|
| DB migrate | `alembic upgrade head` on `sqlite:///release.sqlite3` |
| API server | Starts on port **8001** if `/healthz` down (`limiter.enabled=False`) |
| Unit tests | `npm test -- --run` |
| Production build | `npm run build` |
| Bundle size | `node scripts/check-bundle-size.mjs` |
| Lazy chunks | `npm run smoke:lazy-chunks` |
| Analyze friction | `node scripts/analyze-friction-audit.mjs` |
| Build friction | `node scripts/build-friction-audit.mjs` |
| Train friction | `node scripts/train-friction-audit.mjs` |
| Cross-flow release | `node scripts/release-cross-flow.mjs` |

**Last gate run:** all passed (~174s).

---

## Re-run harness

### Full release gates (recommended)

```powershell
node scripts/run-release-gates.mjs
```

Uses `release.sqlite3` by default. Override with `RELEASE_DATABASE_URL`, `RELEASE_PORT`, `RELEASE_BASE_URL`.

### Cross-flow only

```powershell
# Terminal 1 — release API (port 8001 avoids dev on 8000)
$env:DATABASE_URL="sqlite:///release.sqlite3"
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -c "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1', port=8001)"

# Terminal 2
$env:RELEASE_BASE_URL="http://127.0.0.1:8001"
node scripts/release-cross-flow.mjs
```

Do **not** commit `release.sqlite3-shm` / `release.sqlite3-wal` or `dev.sqlite3-shm` / `dev.sqlite3-wal` (local SQLite WAL artifacts).